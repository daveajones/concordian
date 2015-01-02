//Concordian is a desktop version of Dave Winer's Concord outliner that runs with an S3 back-end
//instead of Dropbox.  It uses Node-Webkit.


//Node modules
var fs = require('fs');
var gui = require('nw.gui');
var AWS = require('aws-sdk');
var crypt = require('crypto');

//Globals
var win = gui.Window.get();
var currentFilePath = null;
var currentTitle = null;
var timerChangeTitle = null;

//Debugging
console.log(process.version);

//Concordian API
var Concordian = Concordian || {
    _fileS3Credentials: function() {
        var file = Concordian._directoryS3Credentials() + "/" + Concordian._fileS3Config;
        if(file === "") {
            console.log("Error getting S3 credentials config file: ["+file+"]");
            return "";
        }
        return file;
    },
    _directoryS3Credentials: function() {
        var dir = Concordian.getUserHome() + '/.concordian';
        fs.stat(dir, function(err, stats) {
            if(err) {
                fs.mkdir(dir, function(err) {
                    if(err) {
                        console.log("Can't create folder: [" + dir + "]");
                        return "";
                    }
                });
            }
        });
        return dir;
    },
    elMenubarLoginStatus: function () {
        return $(document).find('div.menubar span.loggedin');
    },
    loginStatus: function(value) {
        if (typeof value === "undefined") {
            return Concordian.online;
        } else {
            if (value === true) {
                Concordian.elMenubarLoginStatus().html("On-Line");
                Concordian.online = true;
            } else {
                Concordian.elMenubarLoginStatus().html("Off-Line");
                Concordian.online = false;
            }
        }
    },
    getUserHome: function() {
        return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
    },
    openOutlineFromXml: function(data) {
        var divEditor = $('#divEditOutline');
        var outliner = $('#outliner');
        var title = "";

        //Blow away the current outline
        divEditor.remove();

        //Build a new outline structure
        generateOutlineStructure('.content');

        //Load up concord
        outliner.concord({
            "prefs": {
                "outlineFont": "Calibri",
                "outlineFontSize": 18,
                "outlineLineHeight": 24,
                "renderMode": false,
                "readonly": false,
                "typeIcons": appTypeIcons
            }
        });
        opXmlToOutline(data);
        //console.log(data);

        //Get the title
        titleOfOutline = opGetTitle();

        //Globalize
        currentFilePath = "s3file";
        currentTitle = titleOfOutline;

        //Set the title
        $('.divOutlineTitle input.title').attr('value', titleOfOutline);

        //Refresh the outline title
        Concordian.updateOutlineTitle();
    },
    s3CreateCredentialsFile: function(showerror) {
        //Do we want the bad login warning to be present?
        if( showerror ) {
            $('.s3setup div.error').show();
        } else {
            $('.s3setup div.error').hide();
        }
        if( AWS.config.credentials === null || AWS.config.credentials.ccbucket === "undefined" || AWS.config.credentials.ccbucket === "" ) {
            $('.s3setup form input.s3bucket').val( Concordian.generateBucketName() );
        } else {
            $('.s3setup form input.s3bucket').val( AWS.config.credentials.ccbucket );
        }
        $('.s3setup').modal('show');
        $('.s3setup .modal-footer a.btn.cancel, .s3setup .modal-header .close').unbind('click').click(function() {
            $('.s3setup').modal('hide');
            Concordian.loginStatus(false);
        });
        $('.s3setup .modal-footer a.btn.login').unbind('click').click(function() {
            //Get credentials from the modal form and attempt to login
            var awscred = {};
            awscred.accessKeyId = $('.s3setup form input.s3key').val();
            awscred.secretAccessKey = $('.s3setup form input.s3secret').val();
            awscred.region = $('.s3setup form select.s3region').find(':selected').val();
            awscred.ccbucket = $('.s3setup form input.s3bucket').val();
            AWS.config.credentials = awscred;
            $('.s3setup').modal('hide');
            //Concordian.s3CreateConcordianUser(function() { console.log(AWS.config) });
            Concordian.s3TestConnection(function(err) {
                if (err || awscred === "undefined") {
                    setTimeout(function () {
                        Concordian.s3CreateCredentialsFile(true)
                    }, 1000);
                } else {
                    if ( !$('.s3setup form input.s3save').is(':checked') ) {
                        delete awscred.accessKeyId;
                        delete awscred.secretAccessKey;
                    }
                    fs.writeFile(Concordian.s3CredentialsFile, JSON.stringify(awscred));
                }
            });
        });
    },
    s3TestConnection: function(callback) {
        if( AWS.config.credentials.accessKeyId === "undefined" || AWS.config.credentials.secretAccessKey === "undefined") {
            Concordian.setupS3Login();
            return false;
        }
        var awscred = AWS.config;
        console.log("DEBUG: " + AWS);
        var s3 = new AWS.S3({params: {Bucket: AWS.config.credentials.ccbucket}});
        s3.createBucket({}, function(err, data) {
            //If bucket creation was successful, we assume that we have a valid s3 object
            //and save it in the Concordian object, else we set as null
            if(err) {
                console.log("AWS error: [" + err + "]");
                Concordian.s3 = null;
                if(typeof callback === "function") { callback(true); }
                return false;
            } else {
                Concordian.s3 = s3;
            }
            //Try to do a quick file put into our bucket, and if successful we set login status
            //to true, else false
            var filedata = {Key: 'status', Body: 'Hello!'};
            s3.putObject(filedata, function(err, data) {
                if (err) {
                    Concordian.loginStatus(false);
                    if(typeof callback === "function") { callback(true); }
                    return false;
                } else {
                    Concordian.loginStatus(true);
                    if(typeof callback === "function") { callback(false); }
                    return true;
                }
            });
        });
    },
    s3CreateConcordianUser: function(callback) {
        var iam = AWS.IAM();
        iam.createUser({UserName: Concordian.s3DefaultUsername}, function(err, data) {
            console.log(data);
            if( !err && AWS.config.credentials === null || AWS.config.credentials.ccbucket === "undefined" || AWS.config.credentials.ccbucket === "" ) {
                //Get access keys for this user
                iam.createAccessKey({UserName: Concordian.s3DefaultUsername}, function(err, data) {
                    if(!err) {
                        //Save new access keys
                        AWS.config.credentials.accessKeyId = data.AccessKeyId;
                        AWS.config.credentials.secretAccessKey = data.SecretAccessKey;

                        //Create a policy for this user to be able to write to the bucket we make
                        var policy = Concordian.s3DefaultPolicyDocument.replace('[$$BUCKET$$]', AWS.config.credentials.ccbucket);
                        iam.putUserPolicy({PolicyDocument: policy, PolicyName: Concordian.s3DefaultPolicyName, UserName: Concordian.s3DefaultUsername}, function(err, data) {
                            if(typeof callback === "function") {
                                callback();
                            }
                        });
                    } else {
                        console.log("AWS err: ["+err+"]");
                    }
                });
            } else {
                console.log("AWS err: ["+err+"]");
            }
        });
    },
    s3OpenFileDialog: function(callback) {
        $('.s3open .modal-header .close').unbind('click').click(function () {
            $('.s3open').modal('hide');
        });
        //Clear the existing table
        $('.s3open .modal-body .filetable').empty();
        //Get a list of recent opml files and show them in the dialog
        Concordian.s3.listObjects({Bucket: AWS.config.credentials.ccbucket, Prefix: Concordian.s3BucketPrefixOutlines}, function (err, data) {
            //Populate the table in the modal body
            for( var i = 0 ; i < data.Contents.length ; i++ ) {
                var key = data.Contents[i].Key;
                //Don't list the subfolder itself
                if( key === Concordian.s3BucketPrefixOutlines ) {
                    continue;
                }
                //Add each key as a hyperlink and bind an open handler to it
                Concordian.s3.headObject({Bucket:AWS.config.credentials.ccbucket, Key:key}, function ( err, data) {
                    var filekey = key;
                    $('.s3open .modal-body .filetable').append('<tr><td><a href="#" id="fileopen'+i+'" data-key="'+filekey+'">' + data.Metadata.opmltitle + '</a></td></tr>');
                    $('.s3open .modal-body .filetable tr td a#fileopen'+i).unbind('click').click(function() {
                        var keytoget = $(this).attr('data-key');
                        console.log(keytoget);

                        //Get the file contents from s3
                        Concordian.streamData = "";
                        Concordian.s3.getObject({ Bucket: AWS.config.credentials.ccbucket, Key: keytoget }).on('httpData', function(chunk) {
                            Concordian.streamData += chunk;
                        }).on('complete', function() {
                            Concordian.openOutlineFromXml(Concordian.streamData);
                            $('.s3open').modal('hide');
                        }).send();
                    });
                });
            }
            //If we got no data back then add a message
            if( data.Contents.length === 0 ) {
                $('.s3open .modal-body .filetable').append('<tr><td>No outlines found.</td></tr>');
            }
        });
        //Show the modal
        $('.s3open').modal('show');
    },
    s3SaveFile: function (callback) {
        //Sync the title
        if (!Concordian.updateOutlineTitle()) {
            alert('Outlines must have a title.');
            return false;
        }
        //If we had a good title, save the file
        var opmlTitle = opGetTitle();
        var opmlFilename = JSON.stringify(opmlTitle).replace(/\W/g, '');
        var opmlToSave = opOutlineToXml();
        var prevmsg = Concordian.changeStatusMessage("Saving to S3...", true);
        Concordian.s3.putObject({Key: Concordian.s3BucketPrefixOutlines + opmlFilename, Body: opmlToSave, Metadata: { "opmlTitle":opmlTitle}}, function () {
            Concordian.changeStatusMessage(prevmsg, false);
        });
    },
    generateBucketName: function() {
        return Concordian.appName + "-" + randomValueHex(14);
    },
    updateOutlineTitle: function (callback) {
        var title = "";

        //Get the current title in the text box
        title = $('input.title').val();
        currentTitle = title;

        //Update the window caption
        win.title = Concordian.appName + ' - ' + title;

        //Set the title within the concord object
        opSetTitle(title);

        if (typeof callback === "function") {
            callback(title);
        }

        return (!(title === ""));
    },
    newOutline: function (callback) {
        //Blow away the current outline
        Concordian.elEditorContainer.remove();
        generateOutlineStructure('.content', function () {
            opXmlToOutline(initialOpmltext);
            currentFilePath = "./outline.opml";
            currentTitle = "Untitled Outline";
        });
        Concordian.updateOutlineTitle();
    },
    changeStatusMessage: function (message, spinner) {
        var msg = "";
        if (spinner) {
            msg = '<i class="icon-spin icon-spinner"></i> ';
        }
        msg = msg + message;
        var prev = Concordian.elMenubarLoginStatus().html();
        Concordian.elMenubarLoginStatus().html(msg);
        return prev;
    },
    appName: gui.App.manifest.name,
    online: false,
    directoryUserHome: "",
    s3: null,
    streamData: "",
    s3DefaultUsername: "concordian-default",
    s3DefaultPolicyDocument: '{"Statement":[{"Action":"s3:*","Effect":"Allow","Resource":["arn:aws:s3:::[$$BUCKET$$]","arn:aws:s3:::[$$BUCKET$$]/*"]}]}',
    s3DefaultPolicyName: "ConcordianBucketWrite",
    s3CredentialsFile: "",
    s3BucketPrefixOutlines: "opml/",
    elEditorContainer: $('#divEditOutline'),
    elOutliner: $('#outliner'),
    currentFileName: null,
    currentTitle: null,
    _fileS3Config: "config.json"
};
Concordian.directoryUserHome = Concordian.getUserHome();
Concordian.s3CredentialsFile = Concordian._fileS3Credentials();


//Check AWS credentials
try {
    awscred = require(Concordian.s3CredentialsFile);
    if( awscred === null || awscred.ccbucket === "undefined" || awscred.ccbucket === "" ) {
        awscred.ccbucket = Concordian.generateBucketName();
    }
    AWS.config.credentials = awscred;
    Concordian.s3TestConnection(function(err) {
        if (err || awscred == "undefined") {
            setTimeout(function () {
                Concordian.s3CreateCredentialsFile(true)
            }, 1000);
        } else {
            if ($('.s3setup form input.s3save').attr('checked') == "undefined") {
                delete awscred.accessKeyId;
                delete awscred.secretAccessKey;
            }
            fs.writeFile(Concordian.s3CredentialsFile, JSON.stringify(awscred));
        }
    });
} catch (err) {
    Concordian.s3CreateCredentialsFile();
}



//Toolbar button handlers
$('#btnFileOpen').click(function () {
    if (!Concordian.online) {
        $('#open').trigger('click')
    } else {
        Concordian.s3OpenFileDialog()
    }
});
$('#btnFileSave').click(function () {
    if (!Concordian.online) {
        $('#save').trigger('click')
    } else {
        Concordian.s3SaveFile()
    }
});
$('#btnFileNew').click(Concordian.newOutline());


//File opening handler
var openHandler = function () {
    var fileToOpen = $(this).val();
    var titleOfOutline = "";

    if(fileToOpen !== null) {
        fs.readFile(fileToOpen, 'utf-8', function (error, contents) {
            if(error) {
                alert("Error reading file: [" + fileToOpen + "]");
                return false;
            }

            var divEditor = $('#divEditOutline');
            var outliner = $('#outliner');
            var title = "";

            //Blow away the current outline
            divEditor.remove();

            //Build a new outline structure
            generateOutlineStructure('.content');

            //Load up concord
            outliner.concord({
                "prefs": {
                    "outlineFont": "Calibri",
                    "outlineFontSize": 18,
                    "outlineLineHeight": 24,
                    "renderMode": false,
                    "readonly": false,
                    "typeIcons": appTypeIcons
                }
            });
            opXmlToOutline(contents);

            //Get the title
            titleOfOutline = opGetTitle();

            //Globalize
            currentFilePath = fileToOpen;
            currentTitle = titleOfOutline;

            //Set the title
            $('.divOutlineTitle input.title').attr('value', titleOfOutline);

            //Refresh the outline title
            Concordian.updateOutlineTitle();
        });
    }
};
$('#open').change( openHandler );

//File saving handler
var saveHandler = function () {
    //Make sure we have a file open
    if(currentFilePath === null) {
        alert("No file is open.");
        return false;
    }

    var fileToSave = $(this).val();

    //Refresh the outline title
    Concordian.updateOutlineTitle();

    //Get the outline data and save as a file
    var opmlToSave = opOutlineToXml();
    fs.writeFile(fileToSave, opmlToSave);

    //Reset the file save handler so we catch onchange every time
    $(this).unbind('change');
    $(this).val('');
    $(this).change( saveHandler );
};
$('#save').change( saveHandler );



//Create a new html structure to hold the concord outliner
function generateOutlineStructure(el, callback) {
    $(el).append('<div class="row outliner" id="divEditOutline"></div>');
    var outliner = $('.row.outliner');
    outliner.append('<div class="divOutlineTitle"><input class="rendertitle" checked="checked" type="checkbox" title="Render title and byline in the HTML?" /><input class="title input-large" placeholder="Title" type="text" /></div>');
    outliner.append('<div class="outlineinfo pull-right"></div>');
    outliner.append('<div class="loading hide"><i class="icon-refresh icon-spin"></i> Loading...</div>');
    outliner.append('<div class="divOutlinerContainer"><div id="outliner"></div></div>');

    //Title handler
    $('.divOutlineTitle input.title').on('keyup', function () {
        clearTimeout(timerChangeTitle);
        timerChangeTitle = setTimeout(function () {
            //Refresh the outline title
            return Concordian.updateOutlineTitle();
        }, 2000);
    });

    if( typeof callback === "function" ) {
        callback();
    }

    return true;
}


//Generate some random hex chars
//__via http://blog.tompawlak.org/how-to-generate-random-values-nodejs-javascript
function randomValueHex (len) {
    return crypt.randomBytes(Math.ceil(len/2))
        .toString('hex') // convert to hexadecimal format
        .slice(0,len);   // return required number of characters
}

